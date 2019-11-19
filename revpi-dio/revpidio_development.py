import revpimodio2
import sys
def eventfunction(ioname, iovalue):
        #print("Event {} has the value of {}".format(ioname,iovalue))
       print(iovalue)

try:
    raw_input          # Python 2
except NameError:
    raw_input = input  # Python 3

if len(sys.argv) > 2:
    cmd = sys.argv[1].lower()
    pin_input = sys.argv[2]
    rpi = revpimodio2.RevPiModIO(autorefresh=True,direct_output=True)
    rpi.handlesignalend()
    #print(rpi.io[pin_input].value)
    #rpi.io[pin_input].reg_event(eventfunction)c
    #print("Starting main loop")
    #rpi.mainloop()
    if cmd == "in":
        print(rpi.io[pin_input].value)
    elif cmd == "out":
        outputvalue = sys.argv[3]
        print(outputvalue)
        rpi.io[pin_input].value = outputvalue
        print(rpi.io[pin_input].value)
    rpi.mainloop()

else:
    print("Bad parameters - input_pin")
